// FLEET · E13 — THE RELAUNCH SWEEP.  The meta-fix for a defect class, not a fifth instance of it.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE PROPERTY, IN ONE SENTENCE A READER WILL REMEMBER
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//     FOR EVERY QUESTION A FOLD ANSWERS, THE ANSWER MUST BE THE SAME BEFORE AND AFTER A
//     QUIT-AND-OPEN.
//
// That is ADR 006 §1 turned into a test. *`board.json` is the truth, the op log is history.* A
// fold whose answer changes when history is compacted is a fold reading HISTORY to describe the
// PRESENT, and ADR 006 §3.4 names that the anti-pattern by name.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS — four defects in two weeks with one shape
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `_absorbedAttestOps` (LZP-1008), `_absorbedChainOps` (R-1b), R-1b's transferred seat, and the
// audit's F2/F3/F4/F6 are not four bugs. They are ONE:
//
//     a fact lives in an OP · compaction keeps only REGISTERS · a FOLD needs the op ·
//     the refusal is TERMINAL.
//
// Every one of them was invisible to thousands of green rows for the same mechanical reason,
// which the PO verified by counting and which §4 of this file re-measures rather than quotes:
//
//     tests/fleet/e9-attack-coedit.test.js      coEdit 17 · relaunch  0
//     tests/fleet/e9-attack-diverge.test.js     coEdit 22 · relaunch  1
//     scripts/shell-family-e2e.mjs              coEdit  0 · relaunch  1
//
// **Every rig that co-edits never reboots; the rig that reboots never co-edits.** So this file is
// deliberately NOT four more hand-written cases. It ENUMERATES the facts a fold reads — as data,
// the way `tests/helpers/{domains,sync-domains,project-domains}.js` enumerate their inputs — and
// asserts each one survives a quit-and-open. A fold input added next year is a row somebody must
// CLASSIFY (§3 fails until they do) rather than a hole nobody notices.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// EVERY PROBE CARRIES ITS OWN CONTROL — the method, and why it is not optional
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// A probe is `probe(relaunch: boolean) => answer`, and the sweep runs each one TWICE over two
// freshly built circles: once with a quit-and-open in the middle, once without. Three verdicts
// come out of the pair, and keeping them apart is the whole contribution:
//
//   HOLDS            control right, relaunched right.
//   ABSORBED         control RIGHT, relaunched WRONG.  ← the class this file exists for.
//                    The relaunch is the entire difference; the answer is in the op stream.
//   ALWAYS-WRONG     both wrong. NOT a compaction defect — a missing producer, a wrong contract,
//                    a feature nobody wired. Reported separately because "fix compaction" will
//                    not close it and pricing it as compaction work is how F6 got marked built.
//   RIG-BROKEN       control wrong, relaunched right. The probe is measuring itself; loudest.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// ⚠ RED ON ARRIVAL — WHAT WAS MEASURED, AND AGAINST WHICH TREE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The rows below assert the REQUIRED behaviour, not today's. Measured, both ways:
//
//   at `2d092a6` (the audited tree)          **8 pass · 5 fail**
//       ABSORBED  FI-1b [F9·R-1b] · FI-2a [F3] · FI-2b [F3] · FI-3a [F2] · FI-4a [F4]
//       ALWAYS-WRONG  FI-4b [F6]  ← and §3c red with it
//   with the compaction fix in the tree      **13 pass · 0 fail**
//       every domain HOLDS; no row carries an open finding, and each records what it closed
//
// `openFinding` is `null` on every one of those rows and `wasOpenAt` records the finding it
// closed, so a revert reads as a REGRESSION naming the finding — the strictest of the three
// buckets — rather than as a work order somebody is already carrying. See the note below on why
// this is not computed from source markers.
//
// The three buckets, once more, because they are what the file reports rather than what it
// believes: a deviation with `openFinding: null` is a REGRESSION and is listed first and
// loudest; a deviation with an `openFinding` is a WORK ORDER somebody owns; and an `openFinding`
// that now HOLDS is STALE, which is also a failure, because a work order that lies is worse than
// no work order at all.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANTS — one run each, in a scratch copy of the tree, baseline restored between
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Baseline in that copy: **13/13**. Every mutant deletes one repair for THIS defect class.
//
//   M-E13-1  `store.js#_absorbedGovernanceOps` → `return []` (F2/F3's repair, deleted)
//              dies  §2 D_STAGE2 — FI-2a AND FI-2b, both ABSORBED
//              dies  §2 D_STAGE3 — FI-3a, ABSORBED          (11 pass · 2 fail)
//            and FI-3b — the UNGRANTED co-edit — stays green, which is the inverse claim this
//            row exists to make: absorption fails CLOSED, so the defect is an availability
//            defect and not a hole. A fix of the shape "refuse everything after a relaunch"
//            would pass FI-3a and fail nothing else; FI-3b is what stops it.
//
//   M-E13-5  `store.js#_retainedTailLines` — `retained = false`, so `_persistOps` ① stops
//            keeping the admin-chain lines out of compaction (F9/R-1b's repair, deleted)
//              dies  §2 D_STAGE1 — FI-1b alone, and as a REGRESSION rather than a work order,
//                    because the row carries no open finding. That is the right report: a repair
//                    was removed and nobody is carrying a work order for it.
//
//   M-E13-3  `store.js#_absorbedAttestOps` → `return []` (LZP-1008's repair, i.e. the FIRST
//            instance of this class, put back)
//              dies  all five §2 domains (8 pass · 5 fail). Broad, and honestly so: stage 0 is
//                    removed for everybody, so every later stage has nothing to judge. The row
//                    that names it is FI-0a, and §3b is the static guard on the same symbol.
//
//   THE F6 PAIR, and it is the argument for §3 existing at all:
//
//   M-E13-2a `core/materialize.js#isNewOf` — `if (ctx.seqOf)` → `if (false && ctx.seqOf)`
//              dies  §2 D_PROJECT — FI-4b, ALWAYS-WRONG (1 fail)
//              §3c stays GREEN, correctly: the producer exists, the consumer ignores it.
//   M-E13-2b `store.js#_exposureCtx` — the `seqOf:` producer deleted from the returned ctx
//              dies  §2 D_PROJECT — FI-4b, ALWAYS-WRONG
//              dies  §3c — "A FOLD INPUT WITH NO PRODUCER"  (2 fail)
//            Two mutants, one visible symptom, two different repairs — and only §3c tells them
//            apart. **That difference is F6.** A missing producer cannot be found by driving a
//            fold harder, which is why the sweep has a static half.
//
//   MEASURED AND NOT KILLED, recorded because a mutant nobody could kill is evidence too:
//   · `_lastSeenSeqCtx` → `return {}` — 13/13. EQUIVALENT: `ctx.seqOf` comes from
//     `_exposureCtx`, and `materialize.js:479` documents an absent floor as "never seen", so
//     every peer entry legitimately dots. The row is right and the mutant is not a defect.
//   · `_absorbedChainOps` → `return []` — 13/13. EQUIVALENT ON THIS TREE: `_persistOps` ① now
//     RETAINS the admin-chain lines (M-E13-5's subject), so the rebuild is redundant for these
//     rows. At `2d092a6` the same deletion would have mattered.
//
//   HONEST-PATH CONTROLS: the six entries that never carried a finding at all — FI-0a, FI-0b,
//   FI-1a, FI-3b, FI-4c, FI-4d — are green rows on honest paths, and the CONTROL half of every
//   ABSORBED row is right in every mutant above. "The relaunch is the whole difference" is only
//   worth writing down if the run without it is green, and that is what ABSORBED means here.
//
// ZERO DEPENDENCIES. Nothing here is stubbed: a real relay, a real router, a real transport, real
// `sealOp`, one `store.js` module evaluation per Mac over its own `localStorage` image.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  circle, converge, on, engineFor, mkPubSet, patchedOp, pushOp, regsOf,
} from './e9-attack-kit.js';
import { entityUuid as newUuid } from '../../src/js/core/ids.js';
import { familyKey } from '../../src/js/core/ops.js';
import { unsharePatch } from '../../src/js/core/authz.js';
import { brandFamilyPatch } from '../../src/js/crypto/envelope.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src/js');
const read = (rel) => readFileSync(path.join(SRC, rel), 'utf8');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// `openFinding` IS `null` ON EVERY ROW, AND `wasOpenAt` SAYS WHY THAT IS NEWS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// This file was written against `2d092a6`, where five of these rows were RED ON ARRIVAL and the
// compaction fix — another agent's, in `store.js` — had not landed. It has since landed, every
// row holds, and so every `openFinding` here is `null`. That is not a softening: `null` is the
// STRICTER setting. A deviation with `openFinding: null` is reported as a **REGRESSION**, first
// and loudest, rather than as a known work order somebody is already carrying.
//
// The finding each row closed is kept as `wasOpenAt` and printed in every failure report, so a
// revert reads as *"FI-3a, which was F2 at 2d092a6, is wrong again"* rather than as a mystery.
//
// ⚠ AN EARLIER DRAFT COMPUTED `openFinding` FROM SOURCE MARKERS — `store.js` containing
// `_absorbedGovernanceOps`, `_exposureCtx` containing a register seed — so that a revert would
// re-label the rows automatically. It was removed after it broke twice in one hour: the fix was
// still in flight, the private symbols it keyed on moved, and a row went red for the wrong
// reason. A test that asserts the SHAPE of somebody else's in-flight implementation is a test
// that reports their refactor as this file's failure. §3b keeps exactly three such symbols, and
// only because each is a REPAIR whose deletion is itself the finding.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ONE MOVE THE OTHER RIGS NEVER MAKE
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Quit and open again on the same disk.
 *
 * Deliberately thin, and deliberately LOCAL to this file rather than imported: it is the same
 * three lines `tests/helpers/fleet.js#relaunch` performs for the personal fleet — `persistNow()`
 * then `init()` over the same `localStorage` image — with the family engine rebuilt afterwards
 * because a real quit drops it. Every byte it reads back is a byte the store itself wrote.
 *
 * It is a LOWER BOUND on a real relaunch, not an approximation of one: the store module stays in
 * memory here, so a real process boot re-establishes strictly less from RAM and strictly more
 * from disk. A defect this move exposes is exposed by a real relaunch too.
 */
async function quitAndOpen(C, mac) {
  await on(mac, async () => {
    clearTimeout(mac.store._saveTimer);
    await mac.store.persistNow();
    mac.store.ready = false;
    mac.store.listeners.clear();
    await mac.store.init();
    mac.engine = engineFor(C, mac);
  });
}

/** What this Mac's log holds as LINES versus as REGISTERS — the mechanism, as two numbers. */
function shapeOf(mac) {
  return {
    ops: mac.store._log.ops({ includeParked: true }).length,
    horizon: mac.store._log.horizon(),
    registers: [...mac.store._log.registers().keys()].length,
  };
}

// ── the shipped paths, plus the minimum scaffolding the kit does not carry ───────────────────

/** One owner-published `pub.set`, sealed the way `publishSharedEntry` seals. */
async function share(C, mac, fields, level = 'geteilt') {
  const key = familyKey('fnote', mac.forStore.memberId, newUuid());
  await on(mac, async () => {
    await patchedOp(C, mac, mkPubSet(C, mac, key, {
      'pub.level': level, 'pub.alive': true, 'pub.date': '2026-10-14', ...fields,
    }, level), { levelOf: () => level });
    await mac.engine.syncNow();
  });
  await converge(C, C.macs.filter((m) => m !== mac));
  return key;
}

/** The admin's ADR 001 §4.3 unshare, built exactly as `core/project.js#adminUnshareOp` builds it. */
async function adminUnshare(C, admin, key) {
  await on(admin, async () => {
    const ctx = admin.store._ctx();
    await pushOp(C, admin, Object.freeze({
      v: 1, id: ctx.newOpId(), ts: ctx.mint(), space: C.spaceId,
      act: admin.forStore.memberId, dev: admin.forStore.deviceId, gid: ctx.gid,
      k: 'pub.set', e: key,
      f: brandFamilyPatch({ ...unsharePatch('fnote') }, { kind: 'fnote', level: 'privat' }),
    }), {
      levelOf: () => 'privat', adminOf: () => admin.forStore.memberId, assertFamilyPatch: () => {},
    });
    await admin.engine.syncNow();
  });
}

/** `member.set{_alive}` from the admin — story 20.2's removal op, and its inverse the re-add. */
const setAlive = (C, subject, alive) => on(C.papa, async () => {
  const ctx = C.papa.store._ctx();
  await pushOp(C, C.papa, Object.freeze({
    v: 1, id: ctx.newOpId(), ts: ctx.mint(), space: C.spaceId,
    act: C.papa.forStore.memberId, dev: C.papa.forStore.deviceId, gid: ctx.gid,
    k: 'member.set', e: `member:${subject.forStore.memberId}`, f: { _alive: alive },
  }));
  await C.papa.engine.syncNow();
});

/** ADR 001 §4.1's seat transfer: `space.set{admin, adminPrev}` from the seated admin. */
const transferSeat = (C, from, to) => on(from, async () => {
  const head = from.store.familyAdmin().headOpId;
  const ctx = from.store._ctx();
  await pushOp(C, from, Object.freeze({
    v: 1, id: ctx.newOpId(), ts: ctx.mint(), space: C.spaceId,
    act: from.forStore.memberId, dev: from.forStore.deviceId, gid: ctx.gid,
    k: 'space.set', e: `space:${C.spaceId}`,
    f: { admin: to.forStore.memberId, adminPrev: head },
  }));
  await from.engine.syncNow();
});

const textOn = async (mac, key) => (await regsOf(mac, key))?.['pub.text'] ?? null;
const levelOn = async (mac, key) => (await regsOf(mac, key))?.['pub.level'] ?? null;
const notesOn = async (mac) => {
  let out = [];
  await on(mac, () => { out = mac.store.state.notes.map((n) => n.text).sort(); });
  return out;
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE DOMAIN — every fact a fold reads, written down as data
//
// One entry per QUESTION a fold answers, never per BRANCH the code takes. The distinction is
// `tests/helpers/domains.js`'s and it is the reason that file exists: an enumeration of branches
// describes the code that is there; an enumeration of questions describes the world, and the
// world does not shrink when somebody adds an `else if`.
//
//   id           stable. Quote it in a fix, in a commit, in a row.
//   fact         the thing the fold needs.
//   readAt       where it is read, file and stage. The fix's address.
//   question     the question a person would ask. `expect` is its required answer.
//   story        the user-visible promise that breaks when the answer changes.
//   expect       THE REQUIRED ANSWER — the same before and after a quit-and-open. Never today's.
//   probe        `(relaunch:boolean) => answer`, or `null` for an entry carried by another row
//                or repaired elsewhere; a `null` probe MUST carry `why`.
//   openFinding  the audit finding that predicts this entry deviates today, or `null`. A `null`
//                that deviates is NEWS.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** ADR 001 §4.0 — stage 0, device attestation. Repaired by `store.js#_absorbedAttestOps`. */
const D_STAGE0 = {
  title: 'stage 0 · device attestation',
  subject: 'core/authz.js §4.0 — is `op.dev` an attested device of `op.act`?',
  entries: [
    {
      id: 'FI-0a',
      fact: '`member.set{dev.*}` attestation blobs',
      readAt: 'core/authz.js stage 0a/0b (`attestOpen` lookup)',
      question: 'after a relaunch, is a peer\'s ordinary shared entry still admitted at all?',
      story: '15.5 / 16.1',
      ctxKeys: ['me', 'familySpaceId'],
      expect: 'Mamas Eintrag',
      openFinding: null,
      probe: async (relaunch) => {
        const C = await circle(['papa', 'mama', 'oma']);
        if (relaunch) await quitAndOpen(C, C.oma);
        const key = await share(C, C.mama, { 'pub.text': 'Mamas Eintrag' });
        return textOn(C.oma, key);
      },
    },
    {
      id: 'FI-0b',
      fact: 'the write-once floor for a `dev.*` register',
      readAt: 'core/authz.js stage 0a (admissibility, not the LWW join)',
      question: 'after a relaunch, does the fold still hold exactly one attestation per peer?',
      story: 'ADR 002 §2.3 — the key-injection hole',
      ctxKeys: [],
      expect: 1,
      openFinding: null,
      probe: async (relaunch) => {
        const C = await circle(['papa', 'mama']);
        if (relaunch) await quitAndOpen(C, C.papa);
        let n = 0;
        await on(C.papa, () => {
          const cells = C.papa.store.registers().get(`member:${C.mama.forStore.memberId}`);
          n = cells ? [...cells.keys()].filter((k) => k.startsWith('dev.')).length : 0;
        });
        return n;
      },
    },
    {
      id: 'FI-0c',
      fact: 'memberSpaces — which space a member belongs to',
      readAt: 'core/authz.js stage 2 / 3a',
      question: 'carried by FI-0a: a peer op is admitted only if the fold puts her in this space',
      story: '15.5',
      ctxKeys: [],
      expect: null,
      openFinding: null,
      probe: null,
      why: 'carried by FI-0a — an admitted peer op IS the positive answer, and FI-2a is its inverse',
    },
  ],
};

/** ADR 001 §4.1 — stage 1, the admin chain. Partly repaired by `store.js#_absorbedChainOps`. */
const D_STAGE1 = {
  title: 'stage 1 · the admin chain (governance)',
  subject: 'core/authz.js §4.1 — who holds the seat at this stamp?',
  entries: [
    {
      id: 'FI-1a',
      fact: '`space.set{admin, adminPrev}` — the GENESIS link',
      readAt: 'core/authz.js stage 1 (`adminAtKey`)',
      question: 'after a relaunch, is a genesis admin\'s unshare still applied by every Mac?',
      story: '18.3',
      ctxKeys: [],
      expect: { papa: 'privat', mama: 'privat', oma: 'privat' },
      openFinding: null,
      probe: async (relaunch) => {
        const C = await circle(['papa', 'mama', 'oma']);
        const key = await share(C, C.mama, { 'pub.text': 'Mamas Eintrag' });
        if (relaunch) { await quitAndOpen(C, C.oma); await quitAndOpen(C, C.papa); }
        await adminUnshare(C, C.papa, key);
        await converge(C, [C.mama, C.oma]);
        return {
          papa: await levelOn(C.papa, key),
          mama: await levelOn(C.mama, key),
          oma: await levelOn(C.oma, key),
        };
      },
    },
    {
      id: 'FI-1b',
      fact: '`space.set{admin, adminPrev}` — a TRANSFERRED link',
      readAt: 'core/authz.js stage 1; `store.js#_absorbedChainOps` rebuilds `author === value` only',
      question: 'after a relaunch, is a TRANSFERRED admin\'s unshare still applied?',
      story: '18.3 after a seat transfer',
      ctxKeys: [],
      expect: { papa: 'privat', mama: 'privat' },
      openFinding: null,
      wasOpenAt: 'F9 · R-1b — ABSORBED at 2d092a6',
      probe: async (relaunch) => {
        const C = await circle(['papa', 'mama', 'oma']);
        const key = await share(C, C.mama, { 'pub.text': 'Mamas Eintrag' });
        await transferSeat(C, C.papa, C.oma);
        await converge(C, [C.mama, C.oma]);
        // MAMA is the entry's OWNER and a BYSTANDER to the transfer. That is the audit's
        // contribution to R-1b: the victim is not a participant.
        if (relaunch) await quitAndOpen(C, C.mama);
        await adminUnshare(C, C.oma, key);
        await converge(C, [C.papa, C.mama]);
        await converge(C, [C.papa, C.mama]);
        return { papa: await levelOn(C.papa, key), mama: await levelOn(C.mama, key) };
      },
    },
    {
      id: 'FI-1c',
      fact: '`space.set{name}` / `{epoch}` admission',
      readAt: 'core/authz.js stage 1 (the same `adminAtKey`)',
      question: 'carried by FI-1b — the same chain answers both',
      story: '19.x',
      ctxKeys: [],
      expect: null,
      openFinding: null,
      probe: null,
      why: 'carried by FI-1b — one chain, one answer; a separate probe would report R-1b twice',
    },
  ],
};

/** ADR 001 §4.2 — stage 2, membership. Not repaired: `_alive` is rebuilt by nothing. */
const D_STAGE2 = {
  title: 'stage 2 · membership and `_alive`',
  subject: 'core/authz.js §4.2 — is the author a current member of this space?',
  entries: [
    {
      id: 'FI-2a',
      fact: 'member records including `_alive: false`',
      readAt: 'core/authz.js stage 2 (`currentMembers`, a FRESH fold of the ops in this fold)',
      question: 'after a relaunch, is a removed member\'s write still refused by the FOLD?',
      story: '20.2',
      ctxKeys: [],
      expect: { inRegisters: false, onBoard: false },
      openFinding: null,
      wasOpenAt: 'F3 — ABSORBED at 2d092a6',
      probe: async (relaunch) => {
        const C = await circle(['papa', 'mama', 'oma']);
        await share(C, C.mama, { 'pub.text': 'Vor der Entfernung' });
        await setAlive(C, C.mama, false);
        await converge(C, [C.oma]);
        if (relaunch) await quitAndOpen(C, C.oma);
        const key = await share(C, C.mama, { 'pub.text': 'NACH DER ENTFERNUNG' });
        let inRegisters = false;
        await on(C.oma, () => { inRegisters = C.oma.store.registers().has(key); });
        return { inRegisters, onBoard: (await notesOn(C.oma)).includes('NACH DER ENTFERNUNG') };
      },
    },
    {
      id: 'FI-2b',
      fact: 'the same, seen through a RE-JOIN',
      readAt: 'store.js `_withdrawalsOf` — the hazard its own docblock names as owed',
      question: 'after a relaunch, does re-adding a member resurrect what the removal hid?',
      story: '20.2 / 20.5',
      ctxKeys: [],
      expect: ['Mein eigener Eintrag', 'Vor der Entfernung'],
      openFinding: null,
      wasOpenAt: 'F3 — ABSORBED at 2d092a6',
      probe: async (relaunch) => {
        const C = await circle(['papa', 'mama', 'oma']);
        await share(C, C.mama, { 'pub.text': 'Vor der Entfernung' });
        await setAlive(C, C.mama, false);
        await converge(C, [C.oma]);
        if (relaunch) await quitAndOpen(C, C.oma);
        await share(C, C.mama, { 'pub.text': 'WAEHREND DER ENTFERNUNG' });
        await setAlive(C, C.mama, true);
        await converge(C, [C.oma]);
        return notesOn(C.oma);
      },
    },
  ],
};

/** ADR 001 §4.3 — stage 3a/3b, the governing `pub.*` registers. Not repaired. */
const D_STAGE3 = {
  title: 'stage 3 · the governing `pub.*` registers',
  subject: 'core/authz.js §4.3 — may this author write this field of somebody else\'s entry?',
  entries: [
    {
      id: 'FI-3a',
      fact: 'a granting `pub.coEdit` / `pub.level` / `pub.alive`',
      readAt: 'core/authz.js stage 3a builds `govRegs` with `emptyRegs()` and folds THIS fold\'s ops',
      question: 'after a relaunch, does an invited co-editor\'s edit still reach the family?',
      story: '18.2 — „Familie darf bearbeiten"',
      ctxKeys: [],
      expect: { door: 'geteilt', papa: 'Nordsee', oma: 'Nordsee' },
      openFinding: null,
      wasOpenAt: 'F2 — ABSORBED at 2d092a6; story 18.2 died on the second launch',
      probe: async (relaunch) => {
        const C = await circle(['papa', 'mama', 'oma']);
        const key = await share(C, C.papa, { 'pub.coEdit': true, 'pub.text': 'Herbstferien' });
        if (relaunch) { await quitAndOpen(C, C.oma); await quitAndOpen(C, C.papa); }
        let door = null;
        await on(C.mama, async () => {
          // THE DOOR the product asks before it offers the gesture. It reads `store.registers()`,
          // which survives compaction — which is exactly why the failure is silent.
          door = C.mama.store.familyCoEditLevelOf(key);
          C.mama.store.applyCoEdit(key, { 'pub.text': 'Nordsee' });
          await C.mama.engine.syncNow();
        });
        await converge(C, [C.papa, C.oma]);
        await converge(C, [C.papa, C.oma]);
        return { door, papa: await textOn(C.papa, key), oma: await textOn(C.oma, key) };
      },
    },
    {
      id: 'FI-3b',
      fact: 'the ABSENCE of a grant — the inverse direction',
      readAt: 'core/authz.js stage 3b (`REJECT_REASONS.NO_CO_EDIT`)',
      question: 'after a relaunch, is an UNGRANTED co-edit still refused?',
      story: '18.1 — the default is no',
      ctxKeys: [],
      expect: { applied: false, papa: 'Zahnarzt', oma: 'Zahnarzt' },
      openFinding: null,
      probe: async (relaunch) => {
        const C = await circle(['papa', 'mama', 'oma']);
        const key = await share(C, C.papa, { 'pub.text': 'Zahnarzt' });
        if (relaunch) { await quitAndOpen(C, C.oma); await quitAndOpen(C, C.papa); }
        let applied = null;
        await on(C.mama, async () => {
          applied = C.mama.store.applyCoEdit(key, { 'pub.text': 'gekapert' });
          await C.mama.engine.syncNow();
        });
        await converge(C, [C.papa, C.oma]);
        return { applied, papa: await textOn(C.papa, key), oma: await textOn(C.oma, key) };
      },
    },
    {
      id: 'FI-3c',
      fact: 'splice bodies gathered under one opId',
      readAt: 'core/authz.js Pass A (`rememberBody`)',
      question: 'repaired — the bodies are remembered across the fold rather than re-read',
      story: 'ADR 001 §4 Pass A',
      ctxKeys: [],
      expect: null,
      openFinding: null,
      probe: null,
      why: 'repaired by `rememberBody`; §3b asserts the repair is still present in the source',
    },
    {
      id: 'FI-3d',
      fact: 'the withdrawal subtraction set',
      readAt: 'store.js `_repairWithdrawn` / `_withdrawalsOf`',
      question: 'a DECLARED residual — the two mechanisms are owed a joint design',
      story: '18.3',
      ctxKeys: [],
      expect: null,
      openFinding: null,
      probe: null,
      why: 'documented residual in `store.js#_withdrawalsOf`; its consequence is measured by FI-2b',
    },
  ],
};

/** `store.js#_project()` → `materialize()` — the projection's own ctx. */
const D_PROJECT = {
  title: 'the projection ctx · `store.js#_project()` → `core/materialize.js`',
  subject: 'what the renderer is told about the present',
  entries: [
    {
      id: 'FI-4a',
      fact: 'the last ACKED `pub.level`, and the pending-publication set',
      readAt: 'store.js `_exposureCtx()` — one walk over `this._log.lines()`',
      question: 'after a relaunch, does my own shared entry\'s badge still say Geteilt?',
      story: '16.6 · ADR 004 §6 — "the badge never UNDER-reports what others can see"',
      ctxKeys: ['lastAckedPubLevel', 'pendingPub'],
      expect: { visibility: 'geteilt', exposure: { level: 'geteilt', pending: false } },
      openFinding: null,
      wasOpenAt: 'F4 — ABSORBED at 2d092a6; ADR 004 §6\'s forbidden direction',
      probe: async (relaunch) => {
        const C = await circle(['papa', 'mama']);
        let id = null;
        await on(C.papa, async () => {
          id = C.papa.store.state.notes[0].id;
          C.papa.store.txn('set-visibility', (tx) => { tx.note(id).set({ visibility: 'geteilt' }); });
          await C.papa.store.persistNow();
          await C.papa.engine.syncNow();
        });
        await converge(C, [C.mama]);
        if (relaunch) await quitAndOpen(C, C.papa);
        let out = null;
        await on(C.papa, () => {
          const n = C.papa.store.state.notes.find((x) => x.id === id);
          out = { visibility: n.visibility, exposure: n.exposure };
        });
        return out;
      },
    },
    {
      id: 'FI-4b',
      fact: '`ctx.seqOf` / `ctx.isNew` / `ctx.lastSeenSeq` / `ctx.levelDecreased`',
      readAt: 'core/materialize.js `isNewOf` — no producer exists anywhere in `src/js`',
      question: 'does a peer\'s brand-new shared entry carry the quiet „neu" mark?',
      story: '17.5',
      ctxKeys: ['seqOf', 'isNew', 'lastSeenSeq', 'levelDecreased'],
      expect: { present: true, isNew: true },
      openFinding: null,
      wasOpenAt: 'F6 — ALWAYS-WRONG at 2d092a6; a missing producer, not compaction',
      probe: async (relaunch) => {
        const C = await circle(['papa', 'mama']);
        if (relaunch) await quitAndOpen(C, C.mama);
        await share(C, C.papa, { 'pub.text': 'Herbstferien' });
        let row = null;
        await on(C.mama, () => {
          row = C.mama.store.state.notes.find((n) => n.text === 'Herbstferien') ?? null;
        });
        return { present: !!row, isNew: row ? row.isNew : null };
      },
    },
    {
      id: 'FI-4c',
      fact: '`ctx.currentMembers` at RENDER time',
      readAt: 'core/materialize.js §5 step 3 — the filter that makes 20.2 instantaneous',
      question: 'after a relaunch, is a removed member\'s old entry still off the board?',
      story: '20.2',
      ctxKeys: ['currentMembers'],
      expect: ['Mein eigener Eintrag'],
      openFinding: null,
      probe: async (relaunch) => {
        const C = await circle(['papa', 'mama', 'oma']);
        await share(C, C.mama, { 'pub.text': 'Vor der Entfernung' });
        await setAlive(C, C.mama, false);
        await converge(C, [C.oma]);
        if (relaunch) await quitAndOpen(C, C.oma);
        return notesOn(C.oma);
      },
    },
    {
      id: 'FI-4d',
      fact: '`ctx.members` / `ctx.hiddenMembers` — attribution and ownership',
      readAt: 'store.js `_memberCtx(regs)`, read off the register map',
      question: 'after a relaunch, is a peer\'s entry still attributed to that peer?',
      story: '17.2 / 17.6',
      ctxKeys: ['members', 'hiddenMembers', 'defaultSettings'],
      expect: { isForeign: true, level: 'geteilt', ownerIsPapa: true },
      openFinding: null,
      probe: async (relaunch) => {
        const C = await circle(['papa', 'mama']);
        await share(C, C.papa, { 'pub.text': 'Herbstferien' });
        if (relaunch) await quitAndOpen(C, C.mama);
        let out = null;
        await on(C.mama, () => {
          const row = C.mama.store.state.notes.find((n) => n.text === 'Herbstferien') ?? null;
          out = row === null ? null : {
            isForeign: row.isForeign,
            level: row.level,
            ownerIsPapa: row.ownerId === C.papa.forStore.memberId,
          };
        });
        return out;
      },
    },
  ],
};

const DOMAINS = { D_STAGE0, D_STAGE1, D_STAGE2, D_STAGE3, D_PROJECT };
const ALL_ENTRIES = Object.values(DOMAINS).flatMap((d) => d.entries);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE RUNNER AND THE REPORT
// ═════════════════════════════════════════════════════════════════════════════════════════════

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Drive one entry twice — once over a circle that quit and opened, once over one that did not —
 * and classify the pair. No property here stops at its first deviation: a domain walks ALL of its
 * entries and fails once with every one of them listed, so a fix that closes three of four fails
 * on the fourth BY NAME rather than passing.
 */
async function drive(entry) {
  if (!entry.probe) return { entry, verdict: 'CARRIED' };
  let control = null;
  let relaunched = null;
  let threw = null;
  try {
    control = await entry.probe(false);
    relaunched = await entry.probe(true);
  } catch (e) { threw = String((e && e.stack) || e); }
  if (threw !== null) return { entry, verdict: 'THREW', got: { threw } };

  const controlOk = eq(control, entry.expect);
  const relaunchOk = eq(relaunched, entry.expect);
  let verdict = 'HOLDS';
  if (controlOk && !relaunchOk) verdict = 'ABSORBED';
  else if (!controlOk && !relaunchOk) verdict = 'ALWAYS-WRONG';
  else if (!controlOk && relaunchOk) verdict = 'RIG-BROKEN';
  return { entry, verdict, got: { control, relaunched }, same: eq(control, relaunched) };
}

function verdict(domain) {
  return (results) => {
    assert.equal(results.length, domain.entries.length,
      `${domain.title}: ${results.length} entries probed but the domain has `
      + `${domain.entries.length} — a property that skips a domain member is exactly the failure `
      + 'this file exists to prevent');

    const bad = results.filter((r) => r.verdict !== 'HOLDS' && r.verdict !== 'CARRIED');
    const stale = results.filter((r) => r.verdict === 'HOLDS' && r.entry.openFinding);
    if (!bad.length && !stale.length) return;

    const show = (r) => `    ${r.entry.id}  [${r.entry.openFinding ?? r.entry.wasOpenAt ?? 'NO FINDING'}]  ${r.verdict}\n`
      + `        fact      ${r.entry.fact}\n`
      + `        read at   ${r.entry.readAt}\n`
      + `        question  ${r.entry.question}\n`
      + `        story     ${r.entry.story}\n`
      + `        required  ${JSON.stringify(r.entry.expect)}\n`
      + `        control   ${JSON.stringify(r.got?.control ?? r.got?.threw)}\n`
      + `        relaunched ${JSON.stringify(r.got?.relaunched ?? null)}`;

    const bucket = (name) => bad.filter((r) => r.verdict === name);
    const parts = [
      `${domain.title} — ${domain.subject}`,
      `  ${results.length} fold inputs enumerated · `
      + `${results.filter((r) => r.verdict === 'CARRIED').length} carried elsewhere · `
      + `${results.filter((r) => r.verdict === 'HOLDS').length} hold · `
      + `${bucket('ABSORBED').length} ABSORBED · ${bucket('ALWAYS-WRONG').length} ALWAYS-WRONG · `
      + `${bucket('RIG-BROKEN').length} RIG-BROKEN · ${bucket('THREW').length} threw · `
      + `${stale.length} stale`,
    ];
    const unexpected = bad.filter((r) => !r.entry.openFinding);
    if (unexpected.length) {
      parts.push('', '  ⚠ REGRESSION — a fold input nobody has a finding for changed its answer:',
        unexpected.map(show).join('\n'));
    }
    if (bucket('RIG-BROKEN').length) {
      parts.push('', '  ⚠ RIG-BROKEN — the control run is wrong, so this row measures itself:',
        bucket('RIG-BROKEN').map(show).join('\n'));
    }
    if (stale.length) {
      parts.push('', '  STALE — these now hold; close the finding and clear `openFinding`:',
        stale.map((r) => `    ${r.entry.id}  [${r.entry.openFinding}]  ${r.entry.fact}`).join('\n'));
    }
    if (bucket('ABSORBED').length) {
      parts.push('',
        '  THE WORK ORDER · ABSORBED — the control is RIGHT and the relaunch is the whole',
        '  difference. Owner: `core/authz.js` + `store.js` (the compaction fix). These go green',
        '  the day the four facts survive a persist or are rebuilt from the checkpoint:',
        bucket('ABSORBED').map(show).join('\n'));
    }
    if (bucket('ALWAYS-WRONG').length) {
      parts.push('',
        '  NOT A COMPACTION DEFECT · ALWAYS-WRONG — wrong with and without the relaunch, so the',
        '  compaction fix will NOT close it. Pricing it as compaction work is how a unit-green',
        '  story ships rendering nothing:',
        bucket('ALWAYS-WRONG').map(show).join('\n'));
    }
    if (bucket('THREW').length) {
      parts.push('', '  THREW:', bucket('THREW').map(show).join('\n'));
    }
    assert.fail(parts.join('\n'));
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE MECHANISM — the premise of every row below, measured rather than quoted
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · the mechanism, measured — what a quit-and-open does to the log', () => {
  test('§1a · a persist turns LINES into REGISTERS, and the registers all survive', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    await share(C, C.mama, { 'pub.text': 'Mamas Eintrag' });

    let before = null;
    await on(C.oma, () => { before = shapeOf(C.oma); });
    assert.ok(before.ops >= 8,
      `NON-VACUITY: the circle must really hold ops as lines, got ${before.ops}`);
    assert.equal(before.horizon, null, 'before the first persist there is no horizon');

    await quitAndOpen(C, C.oma);
    let after = null;
    await on(C.oma, () => { after = shapeOf(C.oma); });

    // THE MECHANISM, and it is not a threshold: `_persistOps` ① skips every line at or below
    // `_comingHorizon()`, which is the max live stamp — i.e. every line the log holds.
    // `TAIL_COMPACT_AT` (5000) is never reached and is irrelevant; the byte trigger is never
    // reached either. Absorption happens on the FIRST quit-and-open of every install.
    //
    // The number is REPORTED rather than pinned, on purpose. At `2d092a6` it was 8 → 0. The
    // compaction fix rebuilds the governing facts as ops, so it is now 8 → a small positive
    // number — and pinning either value would make this row a test of the fix rather than of the
    // mechanism. What must hold on BOTH sides of the fix is the two invariants below.
    assert.ok(after.ops < before.ops,
      'nothing was absorbed at all, so every row in §2 is vacuous: the relaunch is supposed to '
      + `be the moment ops become registers. before=${before.ops} after=${after.ops}`);
    assert.equal(after.registers, before.registers,
      `not one REGISTER may be lost — which is exactly why nothing downstream notices. `
      + `before=${before.registers} after=${after.registers}`);
    assert.notEqual(after.horizon, null, 'the checkpoint horizon must now cover everything');
    assert.ok(after.ops <= 3,
      'ABSORPTION HAS STOPPED BEING NEARLY TOTAL. §2 measures what survives it; if a persist now '
      + `keeps most of the log, §2's relaunch is no longer the event it claims to be. `
      + `before=${before.ops} after=${after.ops} — re-derive this bound before raising it.`);
  });

  test('§1b · `ops.jsonl` on disk is what the Mac itself wrote, and it is nearly empty', async () => {
    const C = await circle(['papa', 'mama']);
    await share(C, C.papa, { 'pub.text': 'Herbstferien' });
    let before = 0;
    await on(C.papa, () => { before = shapeOf(C.papa).ops; });
    await quitAndOpen(C, C.papa);
    const tail = C.papa.disk['langzeitplaner.ops'];
    const lines = String(tail ?? '').split('\n').filter((l) => l.trim()).length;
    // Not a rig artefact and not this file's arithmetic: these are the bytes `store.persistNow()`
    // put in the tail file. The audit measured 0 here at `2d092a6`.
    assert.ok(lines < before,
      `the tail file kept every line (${lines} of ${before}) — nothing was absorbed, and §2 is `
      + 'then measuring an event that did not happen');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE SWEEP — one property per fold stage, every input driven twice
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · every question a fold answers, before and after a quit-and-open', () => {
  for (const [key, domain] of Object.entries(DOMAINS)) {
    test(`§2 ${key} · ${domain.title}`, async () => {
      const results = [];
      for (const entry of domain.entries) results.push(await drive(entry));
      verdict(domain)(results);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · THE ANTI-BLIND-SPOT GUARD — a fold input added next year must be CLASSIFIED
//
// This is the meta-fix and it is the only part of this file that cannot be satisfied by writing
// one more hand-written case. §2 is only as complete as the enumeration above it; §3 is what
// makes the enumeration provably complete, mechanically, against the source.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * THE CTX CONTRACT — one row per key `materialize.js` reads from its ctx, and what `_project()`
 * owes it. Taken from `materialize.js`'s own docblocks, which state the contract precisely:
 *
 *   `isNewOf`: *"Either hook supplies it, and with neither the dot is simply off"* — so `seqOf`
 *   and `isNew` are ALTERNATIVES and requiring both would be wrong. `lastSeenSeq` and
 *   `levelDecreased` are OPTIONAL with a documented default (absent ⇒ never seen ⇒ everything
 *   dots; absent ⇒ no suppression), which is why `store.js#_lastSeenSeqCtx` legitimately omits
 *   `lastSeenSeq` when this device holds no floor.
 *
 * `need` is one of:
 *   'required'  `_project()` must supply it, always.
 *   'one-of'    at least one key sharing this `group` must be supplied.
 *   'optional'  `materialize.js` documents a default; `why` says what it is.
 *
 * `entry` names the domain row in §2 that DRIVES the key behaviourally. A key with no driving row
 * is a key nothing tests, so §3a requires one.
 */
const CTX = Object.freeze({
  me: { need: 'required', entry: 'FI-0a' },
  familySpaceId: { need: 'required', entry: 'FI-0a' },
  members: { need: 'required', entry: 'FI-4d' },
  currentMembers: { need: 'required', entry: 'FI-4c' },
  hiddenMembers: { need: 'required', entry: 'FI-4d' },
  defaultSettings: { need: 'required', entry: 'FI-4d' },
  lastAckedPubLevel: { need: 'required', entry: 'FI-4a' },
  pendingPub: { need: 'required', entry: 'FI-4a' },
  seqOf: { need: 'one-of', group: 'isNew', entry: 'FI-4b' },
  isNew: { need: 'one-of', group: 'isNew', entry: 'FI-4b' },
  lastSeenSeq: {
    need: 'optional', entry: 'FI-4b',
    why: 'materialize.js:479 — an absent floor means "never seen", so everything dots. '
      + '`_lastSeenSeqCtx` omits the key when this device holds no floor at all.',
  },
  levelDecreased: {
    need: 'optional', entry: 'FI-4b',
    why: 'a SUPPRESSION clause (ADR 004 §7.2 — a downgrade never dots). Absent ⇒ no suppression, '
      + 'which is the fail-open direction and is why it may be omitted.',
  },
});

/**
 * The ctx keys `materialize.js` reads, taken from the source rather than from a list somebody
 * maintains. `grep -o 'ctx\.<ident>'` over the shipped file, comments stripped, is the whole
 * method: it cannot go stale, and a key added next year appears here the moment it is written.
 */
function ctxKeysMaterializeReads() {
  const src = read('core/materialize.js');
  const code = src.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');
  return [...new Set([...code.matchAll(/\bctx\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))].sort();
}

/** What `store.js#_project()` actually hands it, built the way `_project` builds it. */
async function ctxKeysProjectSupplies() {
  const C = await circle(['papa', 'mama']);
  const src = read('store.js');
  const body = src.slice(src.indexOf('_project({ settings = false } = {}) {'));
  const head = body.slice(0, body.indexOf('const next ='));
  // Two kinds of contributor, both read off the source so a THIRD kind cannot slip past: literal
  // `key:` properties of the object passed to `materialize`, and `...this._x(...)` spreads, which
  // are then CALLED on a live family store so their real key sets are used and not guessed.
  const literals = [...head.matchAll(/^\s{6}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]);
  const spreads = [...head.matchAll(/\.\.\.this\.(_[A-Za-z0-9_]+)\(/g)].map((m) => m[1]);
  const keys = new Set(literals);
  await on(C.papa, () => {
    const regs = C.papa.store.registers();
    for (const fn of spreads) {
      const got = C.papa.store[fn](regs) || {};
      for (const k of Object.keys(got)) keys.add(k);
    }
  });
  return { keys: [...keys].sort(), literals, spreads };
}

describe('§3 · the enumeration is complete against the source, and stays complete', () => {
  test('§3a · the ctx contract and `materialize.js` agree, in BOTH directions', () => {
    const reads = ctxKeysMaterializeReads();
    assert.ok(reads.length >= 10,
      `NON-VACUITY: the scan found only ${reads.length} ctx keys — the regex has gone stale`);

    const unclassified = reads.filter((k) => !CTX[k]);
    assert.deepEqual(unclassified, [],
      'A FOLD INPUT NOBODY HAS CLASSIFIED. `core/materialize.js` reads these ctx keys and the '
      + '`CTX` table in this file does not name them. That is the shape of every defect this file '
      + 'exists for: the input was added, no row was, and thousands of green rows stayed green. '
      + 'Give each one a `need` (required / one-of / optional), and an `entry` naming the §2 row '
      + `that drives it. Read from the source: ${JSON.stringify(reads)}`);

    const stale = Object.keys(CTX).filter((k) => !reads.includes(k));
    assert.deepEqual(stale, [],
      'CTX classifies a key `materialize.js` no longer reads. A contract that describes a key '
      + 'nobody uses is how a domain drifts away from its subject; delete the row.');

    // Every key must be DRIVEN by a §2 row, or the classification is paperwork.
    const byId = new Map(ALL_ENTRIES.map((e) => [e.id, e]));
    const undriven = Object.entries(CTX).filter(([k, v]) => {
      const e = byId.get(v.entry);
      return !e || !(e.ctxKeys || []).includes(k);
    }).map(([k, v]) => `${k} → ${v.entry}`);
    assert.deepEqual(undriven, [],
      'a ctx key names a §2 entry that does not exist or does not list it in `ctxKeys` — the '
      + 'static classification and the behavioural sweep have come apart');
  });

  test('§3b · the repairs this class has already needed are still in the source', () => {
    const store = read('store.js');
    const oplog = read('core/oplog.js');
    for (const [name, hay, where] of [
      ['_absorbedAttestOps', store, 'store.js'],
      ['_absorbedChainOps', store, 'store.js'],
      ['rememberBody', oplog, 'core/oplog.js'],
    ]) {
      assert.ok(hay.includes(name),
        `${name} is gone from ${where}. It is a REPAIR for this defect class — deleting it `
        + 're-opens the finding it closed, and FI-0a / FI-1a / FI-3c are the rows that would '
        + 'then go red.');
    }
  });

  test('§3c · every ctx key `materialize.js` requires has a producer in `_project()`', async () => {
    const reads = ctxKeysMaterializeReads();
    const { keys, literals, spreads } = await ctxKeysProjectSupplies();
    assert.ok(spreads.length >= 2 && literals.length >= 3,
      `NON-VACUITY: the _project() scan found ${literals.length} literal keys and `
      + `${spreads.length} spreads — the reconstruction has gone stale and must be re-read`);

    const missing = [];
    const groups = new Map();
    for (const k of reads) {
      const c = CTX[k];
      if (!c || c.need === 'optional') continue;
      if (c.need === 'one-of') {
        if (!groups.has(c.group)) groups.set(c.group, []);
        groups.get(c.group).push([k, keys.includes(k)]);
        continue;
      }
      if (!keys.includes(k)) missing.push(`${k} (required, driven by ${c.entry})`);
    }
    for (const [group, members] of groups) {
      if (!members.some(([, ok]) => ok)) {
        missing.push(`one of [${members.map(([k]) => k).join(', ')}] (group "${group}", `
          + `driven by ${CTX[members[0][0]].entry})`);
      }
    }
    assert.deepEqual(missing, [],
      'A FOLD INPUT WITH NO PRODUCER. `core/materialize.js` reads it and `store.js#_project()` '
      + 'does not supply it, so the function that consumes it has exactly one reachable exit and '
      + 'the feature it serves renders nothing on a real board. That is AUDIT F6 / STORY 17.5 '
      + 'exactly: everything downstream is wired and blameless — board.js appends the dot, '
      + 'layout.js gates it on `foreign`, app.css styles it, `settings.lastSeenSeq.<spaceId>` '
      + 'exists as a pref — and one call site is short of joining them. This is the static half '
      + 'of the sweep, and it is the half that catches a MISSING PRODUCER, which no amount of '
      + `driving a fold can. WAITING ON: store.js#_project(). Supplied: ${JSON.stringify(keys)}`);
  });

  test('§3d · the audit findings this domain descends from, and where each now stands', () => {
    // A REPORT, not a gate. Every row that was red at `2d092a6` says so in `wasOpenAt`, and this
    // row is what makes that visible in a green run — otherwise the only place the history lives
    // is a commit message nobody reads.
    const carried = ALL_ENTRIES.filter((e) => e.wasOpenAt);
    assert.ok(carried.length >= 5,
      `NON-VACUITY: only ${carried.length} rows record what they closed — the audit named five`);
    for (const e of carried) {
      assert.equal(e.openFinding, null,
        `${e.id} carries BOTH an open finding and a closed one; pick one`);
    }
    // eslint-disable-next-line no-console
    console.log('# e13 · rows that were red at 2d092a6: '
      + carried.map((e) => `${e.id} (${e.wasOpenAt.split(' —')[0]})`).join(', '));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · THE BLIND SPOT ITSELF — re-measured here so it cannot come back a fourth time
// ═════════════════════════════════════════════════════════════════════════════════════════════

const GESTURES = [
  { name: 'co-edit', re: /applyCoEdit|pub\.coEdit/, story: '18.2', finding: 'F2' },
  { name: 'removal', re: /_alive|removeMember/, story: '20.2', finding: 'F3' },
  { name: 'exposure badge', re: /\bexposure\b/, story: '16.6', finding: 'F4' },
  { name: 'admin chain', re: /adminPrev|familyAdmin/, story: '18.3', finding: 'F9 · R-1b' },
];
const RELAUNCHES = /relaunch|quitAndOpen/g;
const COEDITS = /applyCoEdit|pub\.coEdit|coEdit/g;
const hits = (src, re) => (src.match(new RegExp(re.source, 'g')) || []).length;

describe('§4 · every family gesture is exercised across a relaunch by SOMETHING', () => {
  test('§4a · the census, and the hole it names', () => {
    const files = readdirSync(HERE).filter((f) => f.endsWith('.js'));
    const census = files.map((f) => {
      const src = readFileSync(path.join(HERE, f), 'utf8');
      return { f, src, relaunches: hits(src, RELAUNCHES), coEdits: hits(src, COEDITS) };
    });

    // The audit's own table, RE-MEASURED rather than quoted. It read, at `2d092a6`:
    //     e9-attack-coedit.test.js   coEdit 17 · relaunch 0
    //     e9-attack-diverge.test.js  coEdit 22 · relaunch 1
    // Printed on every run, because a census that lives in a comment is a census that goes stale
    // the week somebody adds a file.
    const interesting = census
      .filter((c) => c.coEdits > 0 || c.relaunches > 0)
      .sort((a, b) => b.coEdits - a.coEdits);
    // eslint-disable-next-line no-console
    console.log('# e13 · the co-edit / relaunch census of tests/fleet, measured now:\n'
      + interesting.map((c) => `#   ${c.f.padEnd(34)} coEdit ${String(c.coEdits).padStart(3)}`
        + ` · relaunch ${String(c.relaunches).padStart(3)}`).join('\n'));

    const uncovered = [];
    for (const g of GESTURES) {
      const drivers = census.filter((c) => g.re.test(c.src));
      const acrossRelaunch = drivers.filter((c) => c.relaunches > 0);
      if (!acrossRelaunch.length) {
        uncovered.push(`${g.name} (story ${g.story}, finding ${g.finding}) — driven by `
          + `${drivers.map((c) => c.f).join(', ') || 'nothing'}, and by nothing that relaunches`);
      }
    }
    assert.deepEqual(uncovered, [],
      'THE BLIND SPOT IS BACK. A family gesture is exercised in `tests/fleet/` and by nothing '
      + 'that quits and opens first — which is the exact mechanical condition under which four '
      + 'defects in two weeks stayed invisible to 5,612 green rows. This row goes red if this '
      + 'file is deleted or stops relaunching, and that is deliberate: it is the only thing that '
      + 'makes closing the class a property of the suite rather than of somebody\'s memory.');
  });

  test('§4b · this file really is the one that closes it — non-vacuity for §4a', () => {
    const me = readFileSync(path.join(HERE, 'e13-relaunch-sweep.test.js'), 'utf8');
    assert.ok(RELAUNCHES.test(me), 'this file does not relaunch, so §4a is vacuous');
    for (const g of GESTURES) {
      assert.ok(g.re.test(me),
        `§4a would pass without this file driving ${g.name} — the census is measuring the wrong `
        + 'thing, or a gesture moved out of this file and nothing followed it');
    }
  });
});
